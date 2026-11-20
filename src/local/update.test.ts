import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type * as FileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { updateRuntime } from './update.js';
import { AUTOMATIC_POOL_FILE, automaticPoolSources } from './automatic-pool.js';
import type { UpdateRun, UpdateOptions } from './update.js';
import { beginSetupSession } from './setup-session.js';

const cleanup = vi.hoisted(() => ({ fail: false }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof FileSystem>();
  return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
    if (cleanup.fail && String(args[0]).includes('/.update-')) { cleanup.fail = false; throw new Error('Synthetic staging cleanup failure'); }
    return actual.rm(...args);
  } };
});

const execute = promisify(execFile), directories: string[] = [];
afterEach(async () => { cleanup.fail = false; vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
type Settings = { brand?: 'grunt' | 'milo'; duplicate?: boolean; active?: boolean; platform?: 'linux' | 'darwin'; badReady?: boolean; stopError?: boolean; rollbackStopError?: boolean; portEnv?: string; envFile?: string; unsafeNames?: boolean; unsafeLink?: boolean; wrongExec?: boolean; corrupt?: boolean; abort?: AbortController; cancelNpm?: boolean; abortOnStop?: boolean; failBootstrap?: boolean; configMismatch?: boolean; configMissing?: boolean; legacyStatus?: boolean; automaticPool?: boolean };
async function fixture(settings: Settings = {}) {
  const base = await mkdtemp(join(tmpdir(), 'grunt-update-test-')); directories.push(base);
  const brand = settings.brand ?? 'milo', prefix = brand.toUpperCase();
  const directory = join(base, brand), runtime = join(directory, 'runtime'), remote = join(base, 'remote'), pkg = join(remote, 'package'), piDirectory = join(base, 'pi');
  await mkdir(join(runtime, 'dist/local'), { recursive: true, mode: 0o700 });
  await writeFile(join(runtime, 'dist/local/main.js'), 'original runtime');
  await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: 'milo-runtime', version: '0.1.0', type: 'module' }));
  const saved = { 'installed-sources.json': '["freellmapi","perch"]', 'installed-port.json': '8788', 'maintenance.json': '{"keep":"maintenance history"}', 'private-grant.json': 'synthetic private receipt' };
  for (const [name, contents] of Object.entries(saved)) await writeFile(join(directory, name), contents, { mode: 0o600 });
  const unit = join(base, `${brand}.service`), dropIn = join(base, 'custom.conf'), plist = join(base, `ai.${brand}.service.plist`);
  for (const file of [unit, dropIn, plist]) await writeFile(file, 'preserve original service configuration', { mode: 0o600 });
  await mkdir(join(pkg, 'dist/local'), { recursive: true });
  await writeFile(join(pkg, 'dist/local/main.js'), 'if(process.argv[1])throw new Error("CLI must not start while staging");export const fixture=true;');
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'usegrunt', version: '1.2.3', type: 'module', dependencies: {}, scripts: { preinstall: 'do not run this' } }));
  await writeFile(join(pkg, 'README.md'), 'synthetic release');
  const archivePath = join(base, 'release.tgz');
  await execute('tar', ['-czf', archivePath, '-C', remote, 'package']);
  const archive = await readFile(archivePath);
  const metadata = { name: 'usegrunt', version: '1.2.3', dist: { tarball: 'https://registry.npmjs.org/usegrunt/-/usegrunt-1.2.3.tgz', integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64') } };
  let active = settings.active ?? true, loaded = true, stops = 0, starts = 0, clock = Date.now();
  const calls: { binary: string; args: string[] }[] = [], urls: string[] = [];
  const run: UpdateRun = async (binary, args, options) => {
    calls.push({ binary, args }); options?.signal?.throwIfAborted();
    if (binary === 'systemctl') {
      if (args.includes('show')) {
        const name = args[args.indexOf('-p') + 1];
        if (!args.includes(`${brand}.service`) && !settings.duplicate) return name === 'LoadState' ? 'not-found' : '';
        return ({ LoadState: 'loaded', ExecStart: `{ path=${process.execPath} ; argv[]=${process.execPath} ${settings.wrongExec ? '/unrelated/project/main.js' : join(runtime, 'dist/local/main.js')} ; ignore_errors=no ; }`,
          Environment: (settings.automaticPool ? `${prefix}_DAEMON=1 ` : '') + (settings.portEnv ?? `${prefix}_PORT=18792 ${prefix}_SOURCES=freellmapi,perch ${prefix}_FREELLMAPI_URL=http://127.0.0.1:3001/v1`) + (settings.configMissing ? '' : ` ${prefix}_CONFIG_DIR=${settings.configMismatch ? '/unrelated/configuration' : directory}`), EnvironmentFiles: settings.envFile ?? '', UnsetEnvironment: '', ActiveState: active ? 'active' : 'inactive' } as Record<string, string>)[name!] ?? '';
      }
      if (args.includes('stop')) {
        stops++;
        if (settings.rollbackStopError && stops === 2) throw new Error('Synthetic rollback stop failed while candidate is active');
        active = false;
        if (settings.abortOnStop && stops === 1) settings.abort!.abort();
        if (settings.stopError && stops === 1) throw new Error('Synthetic client timed out after stopping');
      }
      if (args.includes('start')) { active = true; starts++; }
      return '';
    }
    if (binary === 'launchctl') {
      if (args[0] === 'print' && args[1] === `gui/${process.getuid!()}`) return `${args[1]} = {\n services = {\n${loaded ? `123 0 ai.${brand}.service\n` : ''} }\n}\n`;
      if (args[0] === 'print') {
        if (!args[1]?.endsWith(`/ai.${brand}.service`) && !settings.duplicate) throw new Error('Synthetic job not installed');
        return `path = ${plist}\nstate = ${active ? 'running' : 'waiting'}\n`;
      }
      if (args[0] === 'list') return `PID\tStatus\tLabel\n${loaded ? `${active ? '123' : '-'}\t0\tai.${brand}.service\n` : ''}`;
      if (args[0] === 'bootout') {
        stops++; if (!loaded) throw new Error('Synthetic launchd job is already unloaded'); active = false; loaded = false;
        if (settings.abortOnStop && stops === 1) settings.abort!.abort();
      }
      if (args[0] === 'bootstrap') {
        starts++; expect(args[2]).toBe(plist);
        if (settings.failBootstrap && starts === 1) throw new Error('Synthetic bootstrap failed before registration');
        active = true; loaded = true;
      }
      return '';
    }
    if (binary === 'plutil') {
      if (args.some(arg => arg.startsWith('EnvironmentVariables.') && !arg.startsWith(`EnvironmentVariables.${prefix}_`)) || args.includes(`EnvironmentVariables.${prefix}_CONFIG_DIR`) && settings.configMissing) throw new Error('Synthetic plist field missing');
      if (args.includes(`EnvironmentVariables.${prefix}_DAEMON`)) return settings.automaticPool ? '1' : '';
      if (args.includes(`EnvironmentVariables.${prefix}_SOURCES`)) return 'freellmapi,perch';
      return args.includes('ProgramArguments') ? JSON.stringify([process.execPath, join(runtime, 'dist/local/main.js')]) : args.includes(`EnvironmentVariables.${prefix}_CONFIG_DIR`) ? settings.configMismatch ? '/unrelated/configuration' : directory : '18792';
    }
    if (binary === 'npm') {
      expect(args).toContain('--ignore-scripts'); expect(args).toContain('--registry=https://registry.npmjs.org');
      const installed = JSON.parse(await readFile(join(args[args.indexOf('--prefix') + 1]!, 'package.json'), 'utf8'));
      expect(installed.scripts).toBeUndefined();
      if (settings.cancelNpm) { settings.abort!.abort(); options?.signal?.throwIfAborted(); }
      return '';
    }
    if (settings.unsafeNames && binary === 'tar' && args[0] === '-tzf') return 'package/package.json\npackage/dist/local/main.js\npackage/../../outside\n';
    if (settings.unsafeNames && binary === 'tar' && args[0] === '-tvzf') return '- fixture\n- fixture\n- fixture\n';
    if (settings.unsafeLink && binary === 'tar' && args[0] === '-tvzf') return (await execute(binary, args)).stdout.replace(/^-/m, 'l');
    return (await execute(binary, args, { ...(options?.signal ? { signal: options.signal } : {}), maxBuffer: 2 * 1024 * 1024 })).stdout;
  };
  const fetcher: typeof fetch = async input => {
    const url = String(input); urls.push(url);
    if (url === 'https://registry.npmjs.org/usegrunt/latest') return new Response(JSON.stringify(metadata));
    if (url === metadata.dist.tarball) return new Response(settings.corrupt ? Buffer.from('bad archive') : archive);
    expect(url).toBe('http://127.0.0.1:18792/v1/status');
    const current = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8'));
    if (settings.legacyStatus && current.version !== '1.2.3') return new Response('legacy status endpoint unavailable', { status: 404 });
    if (settings.badReady && current.version === '1.2.3') return new Response('synthetic unavailable', { status: 503 });
    return new Response(JSON.stringify({ version: 1, activeRequests: 0, sources: [] }));
  };
  const options: UpdateOptions = { directory, env: { MILO_PORT: '8788', PATH: process.env.PATH, PI_CODING_AGENT_DIR: piDirectory }, platform: settings.platform ?? 'linux', run, fetcher, now: () => clock,
    wait: async ms => { clock += ms; }, ...(settings.abort ? { signal: settings.abort.signal } : {}) };
  const preserved = async () => {
    for (const [name, contents] of Object.entries(saved)) expect(await readFile(join(directory, name), 'utf8')).toBe(contents);
    for (const file of [unit, dropIn, plist]) expect(await readFile(file, 'utf8')).toBe('preserve original service configuration');
    expect((await readdir(directory)).some(name => name.startsWith('.setup-session-'))).toBe(false);
  };
  return { directory, runtime, piDirectory, options, calls, urls, metadata, preserved, counts: () => ({ stops, starts, active }) };
}

async function legacyPi(directory: string, port = 18792, contextWindow = 128000) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'models.json');
  const saved = { defaultProvider: 'other', providers: { other: { apiKey: 'synthetic-private-other' }, grunt: {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'local',
    models: [{ id: 'grunt', name: 'grunt', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens: 4096 },
      { id: 'custom-grunt', contextWindow: 200000 }] } } };
  await writeFile(path, JSON.stringify(saved), { mode: 0o600 });
  return { path, saved };
}

it.each(['linux', 'darwin'] as const)('enrolls verified setup-managed services in current curated defaults on update (%s)', async platform => {
  const f = await fixture({ platform, automaticPool: true });
  await updateRuntime(f.options);
  expect(automaticPoolSources(f.directory, ['freellmapi', 'perch'], ['perch', 'reflection-beam'], true)).toEqual(['freellmapi', 'perch', 'reflection-beam']);
  await f.preserved();
});

it('keeps manual source selection and removes a new automatic marker on failed activation', async () => {
  const manual = await fixture(); await updateRuntime(manual.options);
  await expect(readFile(join(manual.directory, AUTOMATIC_POOL_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
  const f = await fixture({ automaticPool: true, badReady: true });
  await expect(updateRuntime(f.options)).rejects.toThrow('previous runtime and service were restored');
  await expect(readFile(join(f.directory, AUTOMATIC_POOL_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
  await f.preserved();
});

it.each([true, false])('migrates the matching managed Pi window only after a successful update (active=%s)', async active => {
  const f = await fixture({ active }), pi = await legacyPi(f.piDirectory), lines: string[] = [];
  const result = await updateRuntime({ ...f.options, notify: line => lines.push(line) });
  expect(result.active).toBe(active);
  const written = JSON.parse(await readFile(pi.path, 'utf8'));
  expect(written.providers.grunt.models[0].contextWindow).toBe(65536);
  expect(written.providers.grunt.baseUrl).toBe('http://127.0.0.1:18792/v1');
  expect(written.providers.grunt.models[1]).toEqual(pi.saved.providers.grunt.models[1]);
  expect(written.providers.other).toEqual(pi.saved.providers.other);
  expect(written.defaultProvider).toBe('other');
  expect((await readdir(f.piDirectory)).filter(name => name.includes('.grunt-backup-'))).toHaveLength(1);
  expect(lines.at(-1)).toBe('Updated the managed Pi working context');
  await f.preserved();
});

it('does not migrate Pi when runtime activation fails', async () => {
  const f = await fixture({ badReady: true }), pi = await legacyPi(f.piDirectory), original = await readFile(pi.path, 'utf8');
  await expect(updateRuntime(f.options)).rejects.toThrow('previous runtime and service were restored');
  expect(await readFile(pi.path, 'utf8')).toBe(original);
  expect((await readdir(f.piDirectory)).filter(name => name.includes('.grunt-backup-'))).toEqual([]);
  await f.preserved();
});

it.each([[18793, 128000], [18792, 200000]] as const)('does not rewrite another Pi endpoint or a custom window (%s/%s)', async (port, contextWindow) => {
  const f = await fixture(), pi = await legacyPi(f.piDirectory, port, contextWindow), original = await readFile(pi.path, 'utf8');
  await updateRuntime(f.options);
  expect(await readFile(pi.path, 'utf8')).toBe(original);
  expect((await readdir(f.piDirectory)).filter(name => name.includes('.grunt-backup-'))).toEqual([]);
  await f.preserved();
});

it('does not create a Pi profile during an ordinary runtime update', async () => {
  const f = await fixture(); await updateRuntime(f.options);
  await expect(readFile(join(f.piDirectory, 'models.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await f.preserved();
});

it('reports a malformed Pi profile without rolling back a healthy updated service or leaking its content', async () => {
  const f = await fixture(), pi = await legacyPi(f.piDirectory), invalid = '{"secret":"synthetic-sensitive-value",', lines: string[] = [];
  await writeFile(pi.path, invalid, { mode: 0o600 });
  expect((await updateRuntime({ ...f.options, notify: line => lines.push(line) })).active).toBe(true);
  expect(JSON.parse(await readFile(join(f.runtime, 'package.json'), 'utf8')).version).toBe('1.2.3');
  expect(f.counts()).toEqual({ stops: 1, starts: 1, active: true });
  expect(await readFile(pi.path, 'utf8')).toBe(invalid);
  expect(lines.at(-1)).toContain('migration was skipped');
  expect(lines.join('\n')).not.toContain('synthetic-sensitive-value');
  await f.preserved();
});

it('fetches latest even from an older CLI and replaces only the managed runtime at the effective custom port', async () => {
  const f = await fixture();
  const result = await updateRuntime(f.options);
  expect(result).toMatchObject({ version: '1.2.3', port: 18792, active: true });
  expect(await readFile(join(result.backup, 'dist/local/main.js'), 'utf8')).toBe('original runtime');
  expect(JSON.parse(await readFile(join(f.runtime, 'package.json'), 'utf8')).version).toBe('1.2.3');
  expect(f.urls[0]).toBe('https://registry.npmjs.org/usegrunt/latest');
  expect(f.counts()).toEqual({ stops: 1, starts: 1, active: true });
  expect(f.calls.some(call => call.args.some(arg => ['enable', 'daemon-reload', '/v1/models'].includes(arg)))).toBe(false);
  await f.preserved();
});
it.each(['linux', 'darwin'] as const)('updates the primary Grunt service without introducing a legacy identity on %s', async platform => {
  const f = await fixture({ brand: 'grunt', platform });
  expect((await updateRuntime(f.options)).port).toBe(18792);
  const actions = f.calls.filter(call => ['systemctl', 'launchctl'].includes(call.binary) && call.args.some(arg => ['start', 'stop', 'bootout', 'bootstrap'].includes(arg)));
  expect(actions).toHaveLength(2);
  expect(actions.every(call => call.args.some(arg => arg.includes('grunt.service')))).toBe(true);
  expect(JSON.parse(await readFile(join(f.runtime, 'package.json'), 'utf8')).name).toBe('grunt-runtime');
  await f.preserved();
});
it('honors primary Grunt settings over legacy aliases in the unchanged installed environment', async () => {
  const f = await fixture({ brand: 'grunt', portEnv: 'MILO_PORT=8788 GRUNT_PORT=18792 MILO_CONFIG_DIR=/unrelated/old-state GRUNT_SOURCES=kilo' });
  expect((await updateRuntime(f.options)).port).toBe(18792);
  expect(f.calls.some(call => call.args.includes('stop') && call.args.includes('grunt.service'))).toBe(true);
  await f.preserved();
});
it.each(['linux', 'darwin'] as const)('refuses two service identities claiming the same saved state on %s', async platform => {
  const f = await fixture({ platform, duplicate: true });
  await expect(updateRuntime(f.options)).rejects.toThrow('Multiple Grunt services');
  expect(f.counts().stops).toBe(0); expect(f.urls).toEqual([]); await f.preserved();
});
it('parses effective Environment tokens without using fake port text inside another quoted variable', async () => {
  const f = await fixture({ portEnv: 'MILO_PORT=8788 "MILO_PORT=18792" "OTHER=example MILO_PORT=8788" "PRIVATE=synthetic\\x20secret\\\" value"' });
  expect((await updateRuntime(f.options)).port).toBe(18792); await f.preserved();
});
it('preserves an intentionally stopped Linux service without probing a possibly unrelated listener', async () => {
  const f = await fixture({ active: false }); const result = await updateRuntime(f.options);
  expect(result.active).toBe(false); expect(f.counts()).toEqual({ stops: 0, starts: 0, active: false });
  expect(f.urls.filter(url => url.startsWith('http://'))).toEqual([]); await f.preserved();
});
it('updates macOS by reloading the same validated plist without rewriting or enabling it', async () => {
  const f = await fixture({ platform: 'darwin' }); await updateRuntime(f.options);
  expect(f.calls.filter(call => call.binary === 'launchctl').map(call => call.args[0])).toEqual(['print', 'print', 'print', 'print', 'bootout', 'bootstrap']);
  await f.preserved();
});
it('restores a running macOS job if bootstrap failed before registering the replacement', async () => {
  const f = await fixture({ platform: 'darwin', failBootstrap: true });
  await expect(updateRuntime(f.options)).rejects.toThrow('previous runtime and service were restored');
  expect(await readFile(join(f.runtime, 'dist/local/main.js'), 'utf8')).toBe('original runtime');
  expect(f.counts().active).toBe(true); await f.preserved();
});
it('restores a macOS job after cancellation immediately following successful bootout', async () => {
  const abort = new AbortController(), f = await fixture({ platform: 'darwin', abort, abortOnStop: true });
  await expect(updateRuntime(f.options)).rejects.toThrow('previous runtime and service were restored');
  expect(await readFile(join(f.runtime, 'dist/local/main.js'), 'utf8')).toBe('original runtime');
  expect(f.counts().active).toBe(true); await f.preserved();
});
it.each(['linux', 'darwin'] as const)('rejects a mismatched service state directory before using the wrong lease on %s', async platform => {
  const f = await fixture({ platform, configMismatch: true });
  await expect(updateRuntime(f.options)).rejects.toThrow('different configuration directory');
  expect(f.urls).toEqual([]); expect(f.counts().stops).toBe(0); await f.preserved();
});
it.each(['linux', 'darwin'] as const)('requires explicit installed service state ownership on %s', async platform => {
  const f = await fixture({ platform, configMissing: true });
  await expect(updateRuntime(f.options)).rejects.toThrow('different configuration directory');
  expect(f.urls).toEqual([]); expect(f.counts().stops).toBe(0); await f.preserved();
});
it('rejects a loaded but non-running macOS KeepAlive job before a filesystem swap', async () => {
  const f = await fixture({ platform: 'darwin', active: false });
  await expect(updateRuntime(f.options)).rejects.toThrow('Start the installed Grunt macOS service');
  expect(f.urls).toEqual([]); expect(f.counts().stops).toBe(0); await f.preserved();
});
it.each([{ corrupt: true }, { unsafeNames: true }, { unsafeLink: true }, { wrongExec: true }, { envFile: '/some/environment.conf' }])('refuses unsafe update input before stopping the service: %j', async settings => {
  const f = await fixture(settings); await expect(updateRuntime(f.options)).rejects.toThrow();
  expect(f.counts()).toEqual({ stops: 0, starts: 0, active: true });
  expect(await readFile(join(f.runtime, 'dist/local/main.js'), 'utf8')).toBe('original runtime'); await f.preserved();
});
it('refuses a tarball outside the official exact-version npm location', async () => {
  const f = await fixture(); f.metadata.dist.tarball = 'https://unrelated.invalid/payload.tgz';
  await expect(updateRuntime(f.options)).rejects.toThrow('unsupported Grunt artifact');
  expect(f.urls).toEqual(['https://registry.npmjs.org/usegrunt/latest']); expect(f.counts().stops).toBe(0); await f.preserved();
});
it('rolls back runtime and original active service when the new daemon does not become ready', async () => {
  const f = await fixture({ badReady: true });
  await expect(updateRuntime(f.options)).rejects.toThrow('previous runtime and service were restored');
  expect(await readFile(join(f.runtime, 'dist/local/main.js'), 'utf8')).toBe('original runtime');
  expect(f.counts()).toEqual({ stops: 2, starts: 2, active: true }); await f.preserved();
});
it('does not rename an active candidate or claim rollback succeeded if rollback cannot stop it', async () => {
  const f = await fixture({ badReady: true, rollbackStopError: true });
  await expect(updateRuntime(f.options)).rejects.toThrow('previous service could not be restarted');
  expect(JSON.parse(await readFile(join(f.runtime, 'package.json'), 'utf8')).version).toBe('1.2.3');
  expect(f.counts()).toEqual({ stops: 2, starts: 1, active: true });
  const backup = (await readdir(f.directory)).find(name => name.startsWith('runtime-backup-'));
  expect(await readFile(join(f.directory, backup!, 'dist/local/main.js'), 'utf8')).toBe('original runtime');
  await f.preserved();
});
it('restores the original active service when stop takes effect but its command reports failure', async () => {
  const f = await fixture({ stopError: true });
  await expect(updateRuntime(f.options)).rejects.toThrow('previous runtime and service were restored');
  expect(f.counts()).toEqual({ stops: 2, starts: 1, active: true });
  expect(await readFile(join(f.runtime, 'dist/local/main.js'), 'utf8')).toBe('original runtime'); await f.preserved();
});
it('cancels staged dependency installation without replacing runtime, service or saved state', async () => {
  const abort = new AbortController(), f = await fixture({ abort, cancelNpm: true });
  await expect(updateRuntime(f.options)).rejects.toThrow(); expect(f.counts().stops).toBe(0);
  expect(await readFile(join(f.runtime, 'dist/local/main.js'), 'utf8')).toBe('original runtime'); await f.preserved();
});
it('restores the active service after cancellation immediately following its stop', async () => {
  const abort = new AbortController(), f = await fixture({ abort, abortOnStop: true });
  await expect(updateRuntime(f.options)).rejects.toThrow('previous runtime and service were restored');
  expect(await readFile(join(f.runtime, 'dist/local/main.js'), 'utf8')).toBe('original runtime'); expect(f.counts().active).toBe(true); await f.preserved();
});
it.each([{ ids: ['kilo'] }, { ids: [] }])('refuses concurrent setup or update claims before downloading any artifact (%j)', async ({ ids }) => {
  const f = await fixture(), lease = await beginSetupSession(f.directory, ids);
  try { await expect(updateRuntime(f.options)).rejects.toThrow('existing setup'); expect(f.urls).toEqual([]); }
  finally { await lease.close(); }
  await f.preserved();
});
it('rejects an archive whose extracted version does not match the integrity-verified metadata', async () => {
  const f = await fixture(); f.metadata.version = '9.9.9'; f.metadata.dist.tarball = 'https://registry.npmjs.org/usegrunt/-/usegrunt-9.9.9.tgz';
  await expect(updateRuntime(f.options)).rejects.toThrow('does not match its release metadata');
  expect(f.calls.some(call => call.binary === 'npm')).toBe(false); expect(f.counts().stops).toBe(0); await f.preserved();
});
it('always releases its lease and signal handlers if staging cleanup fails', async () => {
  const f = await fixture(); const before = process.listenerCount('SIGINT'); cleanup.fail = true;
  const result = await updateRuntime(f.options);
  expect(result.version).toBe('1.2.3'); expect(process.listenerCount('SIGINT')).toBe(before); await f.preserved();
});
it('does not let a failing progress callback leak the update lease or alter activation', async () => {
  const f = await fixture(); const before = process.listenerCount('SIGINT');
  await updateRuntime({ ...f.options, notify: () => { throw new Error('Synthetic output failure'); } });
  expect(process.listenerCount('SIGINT')).toBe(before); await f.preserved();
});
it('updates older installed runtime manifests that have no version field', async () => {
  const f = await fixture();
  await writeFile(join(f.runtime, 'package.json'), JSON.stringify({ name: 'milo-runtime', private: true, type: 'module', dependencies: {} }));
  expect((await updateRuntime(f.options)).version).toBe('1.2.3'); await f.preserved();
});
it('updates an older managed daemon without a status endpoint without probing provider models', async () => {
  const f = await fixture({ legacyStatus: true });
  expect((await updateRuntime(f.options)).version).toBe('1.2.3');
  expect(f.urls.filter(url => url.startsWith('http://'))).toEqual(['http://127.0.0.1:18792/v1/status', 'http://127.0.0.1:18792/v1/status']);
  await f.preserved();
});
it('does not execute caller Node preloads or tar hooks while staging the official package', async () => {
  const f = await fixture(), original = f.options.run!;
  f.options.env = { ...f.options.env, NODE_OPTIONS: '--require=/synthetic/preload', NODE_PATH: '/synthetic/modules', TAR_OPTIONS: '--synthetic-hook' };
  f.options.run = async (binary, args, options) => {
    if (binary !== 'systemctl') {
      expect(options?.env?.NODE_OPTIONS).toBeUndefined(); expect(options?.env?.NODE_PATH).toBeUndefined(); expect(options?.env?.TAR_OPTIONS).toBeUndefined();
    }
    return original(binary, args, options);
  };
  await updateRuntime(f.options); await f.preserved();
});
