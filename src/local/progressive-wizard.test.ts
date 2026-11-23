import { mkdtemp, mkdir, chmod, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
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
  smokeTest: vi.fn(async (_port: number, _signal: AbortSignal) => {}), resumeBackground: vi.fn(async (_port: number) => {}),
  checkServiceSources: vi.fn(async () => {}), checkFallbackServices: vi.fn(async () => {}),
  connectHarnesses: vi.fn(async () => []),
  // Never the real Pi/OpenCode configuration in tests.
  connectHarness: vi.fn(async (..._args: unknown[]) => ({ change: undefined, answer: 'ready' })),
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

it.each([true, false])('finishes at anonymous Kilo once grunt answers, leaving signups to the background (harness available: %s)', async available => {
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
  stub.connectSquire.mockImplementation(async () => {
    const { readSetupSession } = await import('./setup-session.js');
    expect(await readSetupSession(directory)).toBeDefined();
    order.push('squire');
  });
  stub.setupFallbacks.mockImplementation(async options => {
    order.push('signup');
    expect(options.adapters).toEqual(['zro']);
    await options.onSettled?.('zro', false, 'needs human verification');
    return { unavailable: ['zro'] };
  });
  stub.smokeTest.mockImplementation(async () => { order.push('smoke'); });
  stub.resumeBackground.mockImplementation(async () => {
    order.push('background');
    // The daemon's route pass can start only once setup has released its session.
    const { readSetupSession } = await import('./setup-session.js');
    expect(await readSetupSession(directory)).toBeUndefined();
  });
  await wizard(undefined, { ...stub, chooseHarness, connectHarness, signupHarness, probeOperator, createSquire: () => squire });
  // The chosen coding tool is pointed at grunt even though no route drove a signup.
  expect(order).toEqual(['harness', 'kilo', 'smoke', ...(available ? ['completion'] : []), 'squire', 'background']);
  expect(stub.smokeTest).toHaveBeenCalledExactlyOnceWith(8788, expect.any(AbortSignal));
  expect(stub.setupFallbacks).not.toHaveBeenCalled();
  expect(signupHarness).not.toHaveBeenCalled();
  expect(log.mock.calls.map(call => call[0])).toEqual([
    available ? '✓ harness: pi' : '… harness: Squire alone',
    '✓ data sharing: on, no new sources', '✓ local service: running on port 8788',
    '✓ smoke test: grunt answered', '✓ Trusty Squire: already set up and signed in, skipped', '1 ready; 1 more continue in the background (usegrunt status)', 'Ready'
  ]);
});

it('keeps a ready route when Squire bootstrap fails before the background handoff', async () => {
  const stub = actions(['kilo', 'zro']);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  stub.connectSquire.mockRejectedValue(new Error('Squire broker unavailable'));
  await expect(wizard(undefined, { ...stub, chooseHarness: async () => undefined })).resolves.toBeUndefined();
  expect(stub.connectSquire).toHaveBeenCalledOnce();
  expect(stub.resumeBackground).toHaveBeenCalledOnce();
  expect(log.mock.calls.map(call => call[0])).toContain('✗ Trusty Squire: Squire unavailable');
  expect(log.mock.calls.at(-1)).toEqual(['Ready']);
});

it('says why the anonymous Kilo model cannot drive signups', async () => {
  vi.stubEnv('PATH', '');
  const stub = actions(['kilo', 'zro']);
  const { HARNESSES } = await import('./harnesses.js');
  const { BrowserSquire } = await import('./setup.js');
  const { OperatorProbeFailure } = await import('./wizard.js');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const probeOperator = vi.fn(async (_port: number, id: string) => {
    if (id === 'kilo') throw new OperatorProbeFailure('tool-call probe was answered by opencode');
    return false;
  });
  stub.setupFallbacks.mockImplementation(async options => {
    const id = options.adapters![0]!;
    await options.onSettled?.(id, true);
    return { unavailable: [] };
  });
  stub.smokeTest.mockRejectedValueOnce(new Error('quota exhausted'));
  await wizard(undefined, { ...stub, chooseHarness: async () => HARNESSES[0], connectHarness: vi.fn(async () => ({ change: undefined, answer: 'ready' })),
    signupHarness: vi.fn(() => async () => {}), probeOperator, createSquire: () => new BrowserSquire() });
  const lines = log.mock.calls.map(call => String(call[0]));
  expect(lines).toContain('… smoke test: quota exhausted; continuing setup');
  expect(lines).toContain('… operator: kilo cannot drive signups (tool-call probe was answered by opencode)');
  expect(lines).not.toContain('✓ model: grunt (kilo anonymous)');
  expect(stub.smokeTest).toHaveBeenCalledTimes(2);
});

it('drives every later signup with a working anonymous Kilo model', async () => {
  const stub = actions(['kilo', 'zro', 'tokenharbor', 'runcrate']);
  const { HARNESSES } = await import('./harnesses.js');
  const { BrowserSquire } = await import('./setup.js');
  const squire = new BrowserSquire();
  const useSignupAgent = vi.spyOn(squire, 'useSignupAgent');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const probeOperator = vi.fn(async () => true);
  stub.setupFallbacks.mockImplementation(async options => {
    await options.onSettled?.(options.adapters![0]!, true);
    return { unavailable: [] };
  });
  // Grunt does not answer at first, so setup keeps signing up with Kilo driving.
  stub.smokeTest.mockRejectedValueOnce(new Error('quota exhausted'));
  await wizard(undefined, { ...stub, chooseHarness: async () => HARNESSES[0], connectHarness: vi.fn(async () => ({ change: undefined, answer: 'ready' })),
    signupHarness: vi.fn(() => async () => {}), probeOperator, createSquire: () => squire });
  const lines = log.mock.calls.map(call => String(call[0]));
  expect(lines).toContain('✓ model: grunt (kilo anonymous)');
  expect(stub.setupFallbacks.mock.calls.map(call => call[0].adapters)).toEqual([['zro']]);
  expect(lines.filter(line => /bootstrap: .* via Squire/.test(line))).toEqual([]);
  expect(probeOperator).toHaveBeenCalledExactlyOnceWith(expect.any(Number), 'kilo', expect.any(AbortSignal));
  expect(useSignupAgent).toHaveBeenCalledWith(expect.any(Function));
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
  // Grunt never answers through model grunt here, so every signup runs in the foreground.
  stub.smokeTest.mockRejectedValue(new Error('grunt returned HTTP 503'));
  await expect(wizard(undefined, {
    ...stub, chooseHarness: async () => HARNESSES[0], createSquire: () => squire, probeOperator, connectHarness,
    signupHarness: () => { const instance = ++instances; return async () => { if (instance === 1) throw new Error('quota exhausted'); }; }
  })).rejects.toThrow('Grunt did not answer a request through model grunt');
  expect(events).toEqual(['kilo:jev', 'pollinations:jev', 'tool:pollinations', 'beatapi:harness', 'zro:jev', 'tool:zro', 'tokenharbor:harness', 'beatapi:harness']);
  expect(connectHarness).toHaveBeenCalledTimes(2);
});

it('shows waiting on queued sources, connecting only on the one being set up, and background on the rest', async () => {
  vi.stubEnv('GRUNT_SETUP_NO_ANONYMOUS', '1');
  const { HARNESSES } = await import('./harnesses.js');
  const { BrowserSquire } = await import('./setup.js');
  const { SetupTable } = await import('./setup-table.js');
  const rows = new Map<string, string>();
  const history: string[] = [];
  const set = SetupTable.prototype.set;
  vi.spyOn(SetupTable.prototype, 'set').mockImplementation(function (this: InstanceType<typeof SetupTable>, kind, name, status) {
    if (kind === 'source') { rows.set(name, status); history.push(`${name}: ${status}`); }
    return set.call(this, kind, name, status);
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const squire = new BrowserSquire();
  vi.spyOn(squire, 'useSignupAgent').mockImplementation(() => {});
  const stub = actions(['kilo', 'pollinations', 'zro']);
  const first = deferred(), release = deferred();
  let kiloRuns = 0;
  stub.setupFallbacks.mockImplementation(async options => {
    const id = options.adapters![0]!;
    options.onStarted?.(id);
    if (id === 'kilo' && ++kiloRuns === 1) {
      first.resolve();
      await release.promise;
      await options.onSettled?.(id, false, 'needs human verification');
      return { unavailable: [id] };
    }
    await options.onSettled?.(id, true);
    return { unavailable: [] };
  });
  const running = wizard(undefined, {
    ...stub, chooseHarness: async () => HARNESSES[0], createSquire: () => squire,
    probeOperator: vi.fn(async (_port: number, id: string) => id === 'pollinations'),
    connectHarness: vi.fn(async () => ({ change: undefined, answer: 'ready' })), signupHarness: () => async () => {}
  });
  await first.promise;
  try {
    expect(Object.fromEntries(rows)).toEqual({ kilo: 'connecting', pollinations: 'waiting', zro: 'waiting' });
  } finally { release.resolve(); await running; }
  // A signup that needs the person is skipped, never retried for a hand-off.
  expect(kiloRuns).toBe(1);
  expect(Object.fromEntries(rows)).toEqual({ kilo: 'skipped (needs human verification)', pollinations: '✓ ready', zro: 'background' });
  for (const id of ['kilo', 'pollinations']) {
    const own = history.filter(line => line.startsWith(`${id}: `));
    expect(own[0]).toBe(`${id}: waiting`);
    expect(own.indexOf(`${id}: connecting`)).toBeGreaterThan(0);
  }
  expect(history.filter(line => line.startsWith('zro: '))).toEqual(['zro: waiting', 'zro: background']);
});

it('keeps sources queued behind the browser limit on waiting until a browser slot is granted', async () => {
  const { BrowserSquire } = await import('./setup.js');
  const { SetupTable } = await import('./setup-table.js');
  const rows = new Map<string, string>();
  const set = SetupTable.prototype.set;
  vi.spyOn(SetupTable.prototype, 'set').mockImplementation(function (this: InstanceType<typeof SetupTable>, kind, name, status) {
    if (kind === 'source') rows.set(name, status);
    return set.call(this, kind, name, status);
  });
  const squire = new BrowserSquire();
  const client = (squire as unknown as { client: { callTool(...args: unknown[]): Promise<unknown>; close(): Promise<void> } }).client;
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const rpc = vi.spyOn(client, 'callTool').mockImplementation(async request => {
    const { arguments: args } = request as { arguments: { service: string } };
    const gate = deferred(); gates.set(args.service, gate);
    await gate.promise;
    return { content: [], structuredContent: {} };
  });
  vi.spyOn(client, 'close').mockResolvedValue();
  const ids = ['kilo', 'pollinations', 'zro', 'tokenharbor'];
  const stub = actions(ids);
  stub.setupFallbacks.mockImplementation(async options => {
    await Promise.all(options.adapters!.map(async id => {
      options.onStarted?.(id);
      await options.squire!.call('operate_drive', { service: id });
      await options.onSettled?.(id, true);
    }));
    return { unavailable: [] };
  });
  const running = wizard(undefined, { ...stub, createSquire: () => squire });
  try {
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(3));
    const queued = ids.find(id => !gates.has(id))!;
    expect(Object.fromEntries(rows)).toEqual(Object.fromEntries(ids.map(id => [id, id === queued ? 'waiting' : 'connecting'])));
    gates.get([...gates.keys()][0]!)!.resolve();
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(4));
    expect(rows.get(queued)).toBe('connecting');
  } finally {
    for (const id of ids) { await vi.waitFor(() => expect(gates.has(id)).toBe(true)); gates.get(id)!.resolve(); }
    await running;
  }
  expect(Object.fromEntries(rows)).toEqual(Object.fromEntries(ids.map(id => [id, '✓ ready'])));
});

it.each([true, false])('uses an anonymous OpenCode operator before upgrading only with approval: %s', async approved => {
  const bin = await mkdtemp(join(tmpdir(), 'grunt-opencode-bin-'));
  try {
    const { chmod } = await import('node:fs/promises');
    await writeFile(join(bin, 'opencode'), `#!${process.execPath}\nconsole.log('grunt is ready.');\n`);
    await chmod(join(bin, 'opencode'), 0o755);
    vi.stubEnv('PATH', bin);
    const { HARNESSES } = await import('./harnesses.js');
    const { BrowserSquire } = await import('./setup.js');
    const squire = new BrowserSquire();
    vi.spyOn(squire, 'useSignupAgent').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const stub = actions(['zro', 'tokenharbor']);
    if (approved) stub.approveDataSharing.mockResolvedValue({ approved: ['zro', 'tokenharbor', 'opencode'], skipped: [] });
    stub.setupFallbacks.mockImplementation(async options => {
      await options.onSettled?.(options.adapters![0]!, true);
      return { unavailable: [] };
    });
    const signupHarness = vi.fn((_harness: unknown, _port: number, _run?: unknown, _model?: string) => async () => {});
    const probeOperator = vi.fn(async () => true);
    stub.smokeTest.mockRejectedValueOnce(new Error('quota exhausted'));
    await wizard(undefined, { ...stub, chooseHarness: async () => HARNESSES.find(harness => harness.id === 'opencode'),
      connectHarness: vi.fn(async () => ({ change: undefined, answer: 'ready' })), signupHarness, probeOperator, createSquire: () => squire });
    expect(signupHarness.mock.calls.map(call => call[3])).toEqual(approved ? ['opencode/big-pickle', undefined] : [undefined]);
    expect(probeOperator).toHaveBeenCalledExactlyOnceWith(expect.any(Number), 'zro', expect.any(AbortSignal));
  } finally { await rm(bin, { recursive: true, force: true }); }
});

it.each([true, false])('hands signups from an exhausted Pi operator to OpenCode only with approval: %s', async approved => {
  const bin = await mkdtemp(join(tmpdir(), 'grunt-opencode-bin-'));
  try {
    const { chmod } = await import('node:fs/promises');
    await writeFile(join(bin, 'opencode'), `#!${process.execPath}\nconsole.log('grunt is ready.');\n`);
    await chmod(join(bin, 'opencode'), 0o755);
    vi.stubEnv('PATH', bin);
    const { HARNESSES } = await import('./harnesses.js');
    const { BrowserSquire } = await import('./setup.js');
    const squire = new BrowserSquire();
    let driver: Parameters<BrowserSquire['useSignupAgent']>[0];
    vi.spyOn(squire, 'useSignupAgent').mockImplementation(agent => { driver = agent; });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const drivers: string[] = [];
    const stub = actions(['kilo', 'pollinations', 'zro']);
    if (approved) stub.approveDataSharing.mockResolvedValue({ approved: ['kilo', 'pollinations', 'zro', 'opencode'], skipped: [] });
    stub.setupFallbacks.mockImplementation(async options => {
      const id = options.adapters![0]!;
      if (id !== 'kilo') await driver?.({ service: id, url: 'https://test.invalid', goal: 'test', tools: [], signal: new AbortController().signal, call: async () => ({}) }).catch(() => {});
      await options.onSettled?.(id, id === 'kilo');
      return { unavailable: id === 'kilo' ? [] : [id] };
    });
    const signupHarness = vi.fn((harness: { id: string }, _port: number, _run?: unknown, anonymous?: string) => async () => {
      drivers.push(`${harness.id}${anonymous ? ':free' : ''}`);
      if (harness.id === 'pi') throw new Error('No tool-capable adapter is available');
    });
    stub.smokeTest.mockRejectedValue(new Error('grunt returned HTTP 503'));
    await expect(wizard(undefined, { ...stub, chooseHarness: async () => HARNESSES[0], createSquire: () => squire, signupHarness,
      probeOperator: vi.fn(async () => true), connectHarness: vi.fn(async () => ({ change: undefined, answer: 'ready' })) }))
      .rejects.toThrow('Grunt did not answer a request through model grunt');
    expect(drivers).toEqual(approved ? ['pi', 'opencode:free', 'opencode:free'] : ['pi']);
    expect(log.mock.calls.map(call => String(call[0]))).not.toContain('… operator: no working anonymous model; using Squire');
  } finally { await rm(bin, { recursive: true, force: true }); }
});

it.each([
  ['missing', true], ['failed probe', true], ['deferred', true],
  ['missing', false], ['failed probe', false], ['deferred', false]
] as const)('selects OpenCode after provisioning from %s only with approval: %s', async (initial, approved) => {
  const bin = join(directory, 'bin');
  await mkdir(bin);
  vi.stubEnv('PATH', bin);
  const executable = join(bin, 'opencode');
  const install = async (works: boolean) => {
    await writeFile(executable, `#!${process.execPath}\n${works ? "console.log('grunt is ready.');" : 'process.exit(1);'}\n`);
    await chmod(executable, 0o755);
  };
  if (initial === 'failed probe') await install(false);
  const { HARNESSES } = await import('./harnesses.js');
  const { BrowserSquire } = await import('./setup.js');
  const squire = new BrowserSquire();
  let driver: Parameters<BrowserSquire['useSignupAgent']>[0];
  vi.spyOn(squire, 'useSignupAgent').mockImplementation(agent => { driver = agent; });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const stub = actions(['opencode', 'reflection-beam']);
  if (!approved) stub.approveDataSharing.mockResolvedValue({ approved: ['reflection-beam'], skipped: [] });
  const attempts = new Map<string, number>();
  const driven: string[] = [];
  stub.setupFallbacks.mockImplementation(async options => {
    const id = options.adapters![0]!;
    const attempt = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, attempt);
    if (initial === 'deferred' && attempt === 1) {
      await options.onSettled?.(id, false, 'browser could not continue');
      return { unavailable: [id] };
    }
    if (id === 'opencode') await install(true);
    else await driver?.({ service: id, url: 'https://test.invalid', goal: 'test', tools: [], signal: new AbortController().signal, call: async () => ({}) });
    await options.onSettled?.(id, true);
    return { unavailable: [] };
  });
  // OpenCode answers but grunt does not yet, so setup goes on to the next signup.
  stub.smokeTest.mockRejectedValueOnce(new Error('quota exhausted'));
  const running = wizard(undefined, { ...stub, chooseHarness: async () => HARNESSES[0], createSquire: () => squire,
    probeOperator: vi.fn(async () => false),
    signupHarness: (harness, _port, _run, anonymous) => async input => {
      driven.push(`${input.service}:${harness.id}:${anonymous ? 'free' : 'router'}`);
    }
  });
  // A signup that could not continue is not retried for a hand-off.
  if (initial === 'deferred') await expect(running).rejects.toThrow('No adapters passed verification');
  else await running;
  expect(driven).toEqual(approved && initial !== 'deferred' ? ['reflection-beam:opencode:free'] : []);
  expect(attempts.get('opencode')).toBe(1);
});

it.each([true, false])('walks every free harness model before Squire drives alone, with a Pi model answering: %s', async piAnswers => {
  const bin = join(directory, 'bin'), pi = join(directory, 'pi-agent');
  await mkdir(bin);
  await mkdir(pi, { mode: 0o700 });
  vi.stubEnv('PATH', bin);
  vi.stubEnv('PI_CODING_AGENT_DIR', pi);
  // OpenCode's free allowance is exhausted for every model; Pi's own provider answers or fails upstream.
  const probes = join(directory, 'probes.log');
  const record = `require('node:fs').appendFileSync(${JSON.stringify(probes)}, require('node:path').basename(process.argv[1]) + ' ' + process.argv.slice(2).filter(arg => /\\//.test(arg) || /free/.test(arg)).join(' ') + '\\n');`;
  await writeFile(join(bin, 'opencode'), `#!${process.execPath}\n${record}\nconsole.error('AI_APICallError: Free usage limit reached'); setTimeout(() => {}, 60000);\n`, { mode: 0o755 });
  await writeFile(join(bin, 'pi'), `#!${process.execPath}\n${record}\n${piAnswers ? "console.log('grunt is ready.');" : "console.error('upstream error'); process.exit(1);"}\n`, { mode: 0o755 });
  const { HARNESSES } = await import('./harnesses.js');
  const { BrowserSquire } = await import('./setup.js');
  const squire = new BrowserSquire();
  let driver: Parameters<BrowserSquire['useSignupAgent']>[0];
  vi.spyOn(squire, 'useSignupAgent').mockImplementation(agent => { driver = agent; });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const stub = actions(['zro']);
  stub.approveDataSharing.mockResolvedValue({ approved: ['zro', 'opencode'], skipped: [] });
  const driven: string[] = [];
  stub.setupFallbacks.mockImplementation(async options => {
    await driver?.({ service: 'zro', url: 'https://test.invalid', goal: 'test', tools: [], signal: new AbortController().signal, call: async () => ({}) });
    await options.onSettled?.('zro', true);
    return { unavailable: [] };
  });
  const listFreeModels = vi.fn(async (reach: { openCode: boolean; pi: boolean }) => {
    expect(reach).toEqual({ openCode: true, pi: true });
    return [{ harness: 'opencode' as const, model: 'opencode/big-pickle' }, { harness: 'opencode' as const, model: 'opencode/glm-free' },
      { harness: 'pi' as const, model: 'openrouter/vendor/model:free' }];
  });
  await wizard(undefined, { ...stub, chooseHarness: async () => HARNESSES[0], createSquire: () => squire, listFreeModels,
    probeOperator: vi.fn(async () => false),
    signupHarness: (harness, _port, _run, model) => async () => { driven.push(`${harness.id}:${model ?? 'grunt'}`); } });
  const lines = log.mock.calls.map(call => String(call[0]));
  expect(listFreeModels).toHaveBeenCalledExactlyOnceWith({ openCode: true, pi: true }, undefined, expect.any(AbortSignal));
  expect((await readFile(probes, 'utf8')).trim().split('\n')).toEqual(['opencode opencode/big-pickle', 'opencode opencode/glm-free', 'pi vendor/model:free']);
  expect(driven).toEqual(piAnswers ? ['pi:openrouter/vendor/model:free'] : []);
  expect(lines).toContain(piAnswers ? '✓ model: openrouter/vendor/model:free (free)' : '… operator: no working anonymous model; using Squire');
});

it('checks anonymous OpenCode before any signup, so its row shows the state its free-model check found', async () => {
  vi.stubEnv('PATH', '');
  const { HARNESSES } = await import('./harnesses.js');
  const { BrowserSquire } = await import('./setup.js');
  const { SetupTable } = await import('./setup-table.js');
  const rows = new Map<string, string>();
  const set = SetupTable.prototype.set;
  vi.spyOn(SetupTable.prototype, 'set').mockImplementation(function (this: InstanceType<typeof SetupTable>, kind, name, status) {
    if (kind === 'source') rows.set(name, status);
    return set.call(this, kind, name, status);
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const squire = new BrowserSquire();
  vi.spyOn(squire, 'useSignupAgent').mockImplementation(() => {});
  // The registry lists BeatAPI before OpenCode, as the owner's run did.
  const stub = actions(['kilo', 'beatapi', 'opencode']);
  const order: string[] = [];
  stub.connectSquire.mockImplementation(async () => { order.push('squire'); });
  stub.resumeBackground.mockImplementation(async () => { order.push('background'); });
  stub.checkFallbackServices.mockImplementation(async (failed, _port, _notify, ids) => { if (ids![0] === 'kilo') failed.push('kilo'); });
  stub.setupFallbacks.mockImplementation(async options => {
    const id = options.adapters![0]!;
    order.push(id);
    await options.onSettled?.(id, true);
    return { unavailable: [] };
  });
  await wizard(undefined, { ...stub, chooseHarness: async () => HARNESSES[0], createSquire: () => squire,
    probeOperator: vi.fn(async () => false), signupHarness: () => async () => {} });
  expect(stub.setupFallbacks.mock.calls.map(call => call[0].adapters)).toEqual([['opencode']]);
  // Anonymous Kilo failed; its account signup waits for the background with BeatAPI.
  expect(Object.fromEntries(rows)).toEqual({ kilo: 'background', opencode: '✓ ready', beatapi: 'background' });
  expect(stub.resumeBackground).toHaveBeenCalledOnce();
  expect(order).toEqual(['opencode', 'squire', 'background']);
});
