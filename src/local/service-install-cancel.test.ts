import { EventEmitter } from 'node:events';
import { chmod, link, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as ChildProcess from 'node:child_process';
import type * as FileSystem from 'node:fs/promises';
import type * as OperatingSystem from 'node:os';

const fixture = vi.hoisted(() => ({
  spawn: vi.fn(), execFile: vi.fn(), copy: vi.fn(),
  serviceEnvironment: '',
  abortAt: undefined as string | undefined, controller: undefined as AbortController | undefined
}));
vi.mock('node:child_process', async original => ({ ...await original<typeof ChildProcess>(), spawn: fixture.spawn,
  execFile: Object.assign(fixture.execFile, { [Symbol.for('nodejs.util.promisify.custom')]: fixture.execFile }) }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof FileSystem>(), copyFile: fixture.copy }));
vi.mock('node:os', async original => {
  const actual = await original<typeof OperatingSystem>();
  return { ...actual, homedir: () => process.env.GRUNT_TEST_INSTALL_HOME || actual.homedir() };
});
vi.mock('./squire-client-path.js', () => ({ saveSquireClientPath: vi.fn(async () => {}) }));

import { installService, installBackgroundService, preflight } from './wizard.js';
import { automaticPoolSelection } from './automatic-pool.js';
import { installedPort } from './dashboard.js';
import { serviceEnvironment } from './service-environment.js';

let directory: string;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(async () => {
  vi.clearAllMocks(); fixture.abortAt = undefined;
  vi.stubGlobal('fetch', vi.fn(async () => new Response('ok')));
  fixture.serviceEnvironment = '';
  fixture.copy.mockImplementation(async (source: string, destination: string) => writeFile(destination, basename(source)));
  fixture.execFile.mockImplementation(async () => ({ stdout: fixture.serviceEnvironment, stderr: '' }));
  fixture.controller = new AbortController();
  directory = await mkdtemp(join(tmpdir(), 'grunt-install-cancel-'));
  vi.stubEnv('GRUNT_CONFIG_DIR', join(directory, 'grunt'));
  vi.stubEnv('XDG_CONFIG_HOME', join(directory, 'xdg'));
  vi.stubEnv('GRUNT_TEST_INSTALL_HOME', join(directory, 'home'));
  vi.stubEnv('GRUNT_PORT', '18792');
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  await mkdir(join(directory, 'grunt'), { mode: 0o700 });
  await writeFile(join(directory, 'grunt', 'installed-sources.json'), '["opencode"]', { mode: 0o600 });
  fixture.spawn.mockImplementation((binary: string, args: string[], options: { signal?: AbortSignal }) => {
    const child = new EventEmitter();
    options.signal?.addEventListener('abort', () => child.emit('error', new Error('Owned install cancelled')), { once: true });
    queueMicrotask(() => {
      if (args.includes(fixture.abortAt ?? 'unmatched')) fixture.controller!.abort(new Error('Setup ownership lost'));
      else child.emit('exit', 0);
    });
    return child;
  });
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function effectiveEnvironment(unit: string, inherited: string[] = []) {
  const files = (await readdir(unit + '.d')).filter(name => name.endsWith('.conf')).map(name => join(unit + '.d', name));
  const byName = new Map([...inherited, ...files].map(file => [basename(file), file]));
  const overrides = [...byName.values()].sort((a, b) => Buffer.compare(Buffer.from(basename(a)), Buffer.from(basename(b))));
  let environment: NodeJS.ProcessEnv = {};
  for (const file of [unit, ...overrides]) {
    for (const [, assignment] of (await readFile(file, 'utf8')).matchAll(/^Environment=(.*)$/gm)) {
      if (assignment) Object.assign(environment, serviceEnvironment(assignment));
      else environment = {};
    }
  }
  return environment;
}

it('does not start an already-cancelled runtime installation', async () => {
  fixture.controller!.abort();
  await expect(installService(['kilo'], { signal: fixture.controller!.signal })).rejects.toThrow();
  expect(fixture.copy).not.toHaveBeenCalled(); expect(fixture.spawn).not.toHaveBeenCalled();
  expect(await readFile(join(directory, 'grunt', 'installed-sources.json'), 'utf8')).toBe('["opencode"]');
});

it('cancels a held daemon copy before publishing files or changing the service', async () => {
  const unit = join(directory, 'xdg', 'systemd', 'user', 'milo.service');
  await mkdir(join(directory, 'xdg', 'systemd', 'user'), { recursive: true });
  await writeFile(unit, 'previous service', { mode: 0o600 });
  const before = await stat(unit);
  let finishCopy!: () => void;
  fixture.copy.mockImplementationOnce(async (source: string, destination: string) => {
    await new Promise<void>(resolve => { finishCopy = resolve; });
    await writeFile(destination, basename(source));
  });
  const pending = installService(['kilo'], { signal: fixture.controller!.signal });
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(finishCopy).toBeDefined());
  fixture.controller!.abort(new Error('Setup ownership lost'));
  finishCopy();
  await rejected;
  expect(fixture.spawn).not.toHaveBeenCalled();
  await expect(readFile(join(directory, 'grunt/runtime/daemon.mjs'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(unit, 'utf8')).toBe('previous service');
  expect((await stat(unit)).mtimeMs).toBe(before.mtimeMs);
  expect(await readFile(join(directory, 'grunt', 'installed-sources.json'), 'utf8')).toBe('["opencode"]');
  await expect(readFile(join(directory, 'grunt', 'installed-port.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('propagates ownership cancellation to systemd and does not continue with enable/restart/persistence', async () => {
  fixture.abortAt = 'daemon-reload';
  await expect(installService(['kilo'], { signal: fixture.controller!.signal })).rejects.toThrow();
  expect(fixture.spawn.mock.calls.map(([binary, args]) => [binary, args])).toEqual([['systemctl', ['--user', 'daemon-reload']]]);
  expect(await readFile(join(directory, 'grunt', 'installed-sources.json'), 'utf8')).toBe('["opencode"]');
});

it('does not swallow cancellation of launchctl bootout and bootstrap an obsolete installation', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  fixture.abortAt = 'bootout';
  await expect(installService(['kilo'], { signal: fixture.controller!.signal })).rejects.toThrow();
  expect(fixture.spawn.mock.calls.map(([binary]) => binary)).toEqual(['launchctl']);
  expect(fixture.spawn.mock.calls[0]![1][0]).toBe('bootout');
  expect(await readFile(join(directory, 'grunt', 'installed-sources.json'), 'utf8')).toBe('["opencode"]');
});

it('publishes a successful installation with the same owner signal on every child command', async () => {
  await installService(['kilo'], { signal: fixture.controller!.signal });
  expect(fixture.spawn.mock.calls.map(([binary]) => binary)).toEqual(['systemctl', 'systemctl', 'loginctl', 'systemctl']);
  for (const [, , options] of fixture.spawn.mock.calls) expect(options.signal).toBe(fixture.controller!.signal);
  expect(fixture.spawn.mock.calls.at(-1)![1]).toEqual(['--user', 'restart', 'grunt.service']);
  expect(await readFile(join(directory, 'grunt', 'installed-sources.json'), 'utf8')).toBe('["kilo"]');
  expect(JSON.parse(await readFile(join(directory, 'grunt', 'installed-port.json'), 'utf8'))).toBe(18792);
  expect((await stat(join(directory, 'grunt', 'installed-port.json'))).mode & 0o777).toBe(0o600);
});

it('keeps the service installed and explains lingering when the user may not enable it', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  fixture.spawn.mockImplementation((binary: string) => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', binary === 'loginctl' ? 1 : 0));
    return child;
  });
  await installService(['kilo']);
  expect(fixture.spawn.mock.calls.at(-1)![1]).toEqual(['--user', 'restart', 'grunt.service']);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('loginctl enable-linger'));
});

it('stops before restarting when setup ownership is lost while enabling lingering', async () => {
  fixture.abortAt = 'enable-linger';
  await expect(installService(['kilo'], { signal: fixture.controller!.signal })).rejects.toThrow();
  expect(fixture.spawn.mock.calls.map(([, args]) => args)).not.toContainEqual(['--user', 'restart', 'grunt.service']);
});

it('atomically replaces a stale port hint without following its symlink or changing the unrelated target', async () => {
  const hint = join(directory, 'grunt', 'installed-port.json'), unrelated = join(directory, 'unrelated-file');
  await writeFile(unrelated, 'preserve this file', { mode: 0o600 });
  await symlink(unrelated, hint);
  await installService(['kilo']);
  expect(await readFile(unrelated, 'utf8')).toBe('preserve this file');
  expect(JSON.parse(await readFile(hint, 'utf8'))).toBe(18792);
  expect((await stat(hint)).mode & 0o777).toBe(0o600);
});

it('keeps the no-options installation API compatible', async () => {
  await installService(['kilo']);
  expect(fixture.spawn.mock.calls.at(-1)![1]).toEqual(['--user', 'restart', 'grunt.service']);
  for (const [, , options] of fixture.spawn.mock.calls) expect(options.signal).toBeUndefined();
});

it('copies just the daemon and registry and points the new systemd unit at the bundle', async () => {
  await installService(['kilo']);
  const unit = await readFile(join(directory, 'xdg/systemd/user/grunt.service'), 'utf8');
  expect(unit).toContain('GRUNT_CONFIG_DIR='); expect(unit).toContain('GRUNT_PORT=18792');
  expect(unit).toContain('GRUNT_SOURCES=kilo');
  expect(unit).toContain(join(directory, 'grunt/runtime/daemon.mjs'));
  expect(unit).not.toContain('MILO_');
  expect(await readFile(join(directory, 'grunt/runtime/daemon.mjs'), 'utf8')).toBe('daemon.mjs');
  expect(await readFile(join(directory, 'grunt/runtime/registry/adapters.json'), 'utf8')).toBe('adapters.json');
  await expect(stat(join(directory, 'grunt/runtime/package.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(join(directory, 'grunt/runtime/node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['milo', 'grunt'])('moves the installed %s unit to the bundle and keeps its custom drop-in and port', async identity => {
  const units = join(directory, 'xdg/systemd/user'), unit = join(units, `${identity}.service`), dropIn = join(units, `${identity}.service.d/custom.conf`);
  const prefix = identity.toUpperCase();
  const entry = join(directory, 'grunt/runtime/dist/local/main.js');
  const original = `[Service]\nExecStart="${process.execPath}" "${entry}"\nEnvironment="${prefix}_CONFIG_DIR=${join(directory, 'grunt')}"\nEnvironment="${prefix}_PORT=8788"\n`;
  const custom = `[Service]\nEnvironment="${prefix}_PORT=8792"\nEnvironment="${prefix}_OPENCODE_URL=http://127.0.0.1:3301/v1"\n`;
  await mkdir(join(units, `${identity}.service.d`), { recursive: true });
  await writeFile(unit, original, { mode: 0o600 }); await writeFile(dropIn, custom, { mode: 0o600 });
  fixture.serviceEnvironment = `${prefix}_CONFIG_DIR=${join(directory, 'grunt')} ${prefix}_PORT=8792 ${prefix}_SOURCES=opencode,kilo ${prefix}_OPENCODE_URL=http://127.0.0.1:3301/v1`;
  await installService(['kilo', 'antseed-vikey']);
  const current = await readFile(join(units, 'grunt.service'), 'utf8');
  expect(await readFile(join(units, 'grunt.service.d/custom.conf'), 'utf8')).toBe(custom);
  expect(current).toBe(original.replace(entry, join(directory, 'grunt/runtime/daemon.mjs')));
  if (identity === 'milo') {
    expect(await effectiveEnvironment(join(units, 'grunt.service'))).toMatchObject({
      GRUNT_PORT: '8792', GRUNT_OPENCODE_URL: 'http://127.0.0.1:3301/v1'
    });
    expect(fixture.spawn.mock.calls.map(([, args]) => args)).toContainEqual(['--user', 'stop', 'milo.service']);
    expect(fixture.execFile.mock.calls.map(([, args]) => args)).toEqual(expect.arrayContaining([
      ['--user', 'disable', 'milo.service'], ['--user', 'enable', 'grunt.service'], ['--user', 'start', 'grunt.service']
    ]));
  } else {
    expect(fixture.spawn.mock.calls.map(([, args]) => args)).toContainEqual(['--user', 'restart', 'grunt.service']);
  }
  expect(JSON.parse(await readFile(join(directory, 'grunt/installed-port.json'), 'utf8'))).toBe(8792);
  // The owned service file can keep its old source environment while setup
  // enrolls newly curated sources through a private, matching selection anchor.
  expect(automaticPoolSelection(join(directory, 'grunt'), ['opencode', 'kilo'], ['opencode', 'kilo', 'reflection-beam'], true).sources).toEqual(['opencode', 'kilo', 'antseed-vikey', 'reflection-beam']);
  expect(automaticPoolSelection(join(directory, 'grunt'), ['kilo'], ['opencode', 'kilo', 'reflection-beam'], true).sources).toEqual(['kilo']);
  expect(JSON.parse(await readFile(join(directory, 'grunt/installed-sources.json'), 'utf8'))).toEqual(['kilo', 'antseed-vikey']);
  await expect(readFile(join(units, 'milo.service'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

const lastOverrideName = '\u{10fffd}'.repeat(62) + '\u07ff.conf';
it.each([
  { label: 'service override', ownerOverride: 'zz-owner.conf' },
  { label: 'inherited override', ownerOverride: 'zz-owner.conf', inheritedOverride: 'zzzz-type.conf' },
  { label: 'maximum-length service override', ownerOverride: 'z'.repeat(250) + '.conf' },
  { label: 'maximum-length inherited override', ownerOverride: 'zz-owner.conf', inheritedOverride: 'é'.repeat(125) + '.conf' },
  { label: 'last possible service override', ownerOverride: lastOverrideName },
  { label: 'last possible hard-linked service override', ownerOverride: lastOverrideName, hardLinked: true },
  { label: 'last possible inherited override', ownerOverride: 'zz-owner.conf', inheritedOverride: lastOverrideName }
])('keeps the effective state directory and port after a reset in a $label', async ({ ownerOverride, inheritedOverride, hardLinked }) => {
  const units = join(directory, 'xdg/systemd/user');
  const legacy = join(units, 'milo.service'), current = join(units, 'grunt.service');
  const state = join(directory, 'grunt'), entry = join(state, 'runtime/dist/local/main.js');
  const reset = `[Service]\nEnvironment=\nEnvironment="MILO_CONFIG_DIR=${state}" "MILO_PORT=8792"\n`;
  const inheritedFiles = inheritedOverride ? [join(units, 'service.d', inheritedOverride)] : [];
  if (inheritedFiles[0]) {
    await mkdir(join(units, 'service.d'), { recursive: true });
    await writeFile(inheritedFiles[0], reset, { mode: 0o600 });
  }
  await mkdir(legacy + '.d', { recursive: true });
  await writeFile(legacy, `[Service]\nExecStart="${process.execPath}" "${entry}"\nEnvironment="MILO_PORT=8788"\n`, { mode: 0o600 });
  await writeFile(join(legacy + '.d', ownerOverride), reset, { mode: 0o600 });
  const otherOverride = join(units, 'other.service.d', 'shared.conf');
  if (hardLinked) {
    await mkdir(join(units, 'other.service.d'));
    await link(join(legacy + '.d', ownerOverride), otherOverride);
  }
  fixture.execFile.mockImplementation(async (_binary: string, args: string[]) => {
    if (args.includes('Environment')) {
      const effective = await effectiveEnvironment(legacy, inheritedFiles);
      return { stdout: Object.entries(effective).map(([name, value]) => `"${name}=${value}"`).join(' ') };
    }
    if (args.includes('DropInPaths')) return { stdout: [join(legacy + '.d', ownerOverride), ...inheritedFiles].join(' ') };
    if (args.includes('start') && args.includes('grunt.service')) {
      expect(await effectiveEnvironment(current, inheritedFiles)).toMatchObject({ GRUNT_CONFIG_DIR: state, GRUNT_PORT: '8792' });
    }
    return { stdout: '' };
  });
  await installService(['kilo']);
  const ownerOverrideContents = await readFile(join(current + '.d', ownerOverride), 'utf8');
  if (ownerOverride === lastOverrideName) expect(ownerOverrideContents.startsWith(reset)).toBe(true);
  else expect(ownerOverrideContents).toBe(reset);
  if (hardLinked) {
    expect(await readFile(otherOverride)).toEqual(Buffer.from(reset));
    const replacement = await stat(join(current + '.d', ownerOverride));
    expect(replacement.ino).not.toBe((await stat(otherOverride)).ino);
    expect(replacement.mode & 0o777).toBe(0o600);
  }
  if (inheritedFiles[0]) expect(await readFile(inheritedFiles[0], 'utf8')).toBe(reset);
  expect(await readFile(join(state, 'installed-port.json'), 'utf8')).toBe('8792');
});

it.each(['owner.conf', lastOverrideName])('restores the old runtime and override when migration cannot start Grunt', async ownerOverride => {
  const units = join(directory, 'xdg/systemd/user'), oldUnit = join(units, 'milo.service');
  const state = join(directory, 'grunt'), runtime = join(state, 'runtime');
  const entry = join(runtime, 'dist/local/main.js');
  const original = `[Service]\nExecStart="${process.execPath}" "${entry}"\n`;
  await mkdir(oldUnit + '.d', { recursive: true });
  await writeFile(oldUnit, original, { mode: 0o600 });
  const override = '[Service]\nEnvironment=MILO_PORT=8792\n';
  const originalOverride = join(oldUnit + '.d', ownerOverride), otherOverride = join(units, 'linked-override');
  await writeFile(originalOverride, override, { mode: 0o600 });
  await link(originalOverride, otherOverride);
  await mkdir(runtime, { mode: 0o700 });
  const oldRuntime = join(runtime, 'previous-runtime');
  await writeFile(oldRuntime, 'old runtime');
  fixture.execFile.mockImplementation(async (_binary: string, args: string[]) => {
    if (args.includes('Environment')) return { stdout: `MILO_CONFIG_DIR=${state} MILO_PORT=8792 MILO_SOURCES=opencode` };
    if (args.includes('ActiveState')) return { stdout: 'active' };
    if (args.includes('UnitFileState')) return { stdout: 'enabled' };
    if (args.includes('start') && args.includes('grunt.service')) {
      expect(await readFile(otherOverride)).toEqual(Buffer.from(override));
      throw new Error('Synthetic start failure');
    }
    if (args.includes('start') && args.includes('milo.service')) expect(await readFile(oldRuntime, 'utf8')).toBe('old runtime');
    return { stdout: '' };
  });
  await expect(installService(['kilo'])).rejects.toThrow('Synthetic start failure');
  expect(await readFile(oldUnit, 'utf8')).toBe(original);
  expect(await readdir(oldUnit + '.d')).toEqual([ownerOverride]);
  expect(await readFile(originalOverride, 'utf8')).toBe(override);
  expect((await stat(originalOverride)).ino).toBe((await stat(otherOverride)).ino);
  await expect(readFile(join(units, 'grunt.service'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readdir(join(units, 'grunt.service.d'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(fixture.execFile.mock.calls.map(([, args]) => args)).toContainEqual(['--user', 'start', 'milo.service']);
});

it('does not start either identity when duplicate legacy and Grunt services are installed', async () => {
  const units = join(directory, 'xdg/systemd/user'), entry = join(directory, 'grunt/runtime/dist/local/main.js');
  const original = `[Service]\nExecStart="${process.execPath}" "${entry}"\n`;
  await mkdir(units, { recursive: true });
  for (const name of ['grunt', 'milo']) await writeFile(join(units, `${name}.service`), original, { mode: 0o600 });
  await expect(installBackgroundService(entry, {})).rejects.toThrow('Multiple Grunt service identities');
  expect(fixture.spawn).not.toHaveBeenCalled();
});

it('writes a primary Grunt launch agent for a fresh macOS installation', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  await installService(['kilo']);
  const plist = await readFile(join(directory, 'home/Library/LaunchAgents/ai.grunt.service.plist'), 'utf8');
  expect(plist).toContain('<string>ai.grunt.service</string>'); expect(plist).toContain('<key>GRUNT_CONFIG_DIR</key>');
  expect(plist).toContain('<key>GRUNT_PORT</key>'); expect(plist).not.toContain('MILO_');
  expect(fixture.spawn.mock.calls.at(-1)![1]).toEqual(['bootstrap', `gui/${process.getuid!()}`, join(directory, 'home/Library/LaunchAgents/ai.grunt.service.plist')]);
});

it('replaces the legacy macOS launch agent and preserves its port and endpoint settings', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  const file = join(directory, 'home/Library/LaunchAgents/ai.milo.service.plist');
  const entry = join(directory, 'grunt/runtime/dist/local/main.js');
  const original = `<plist><array><string>${process.execPath}</string><string>${entry}</string></array><dict><key>MILO_PORT</key><string>8792</string><key>MILO_OPENCODE_URL</key><string>http://127.0.0.1:3301/v1</string></dict></plist>`;
  await mkdir(join(directory, 'home/Library/LaunchAgents'), { recursive: true }); await writeFile(file, original, { mode: 0o600 });
  fixture.execFile.mockImplementation(async (_binary: string, args: string[]) => {
    if (args.includes('EnvironmentVariables')) return { stdout: JSON.stringify({
      MILO_CONFIG_DIR: join(directory, 'grunt'), MILO_PORT: '8792', MILO_OPENCODE_URL: 'http://127.0.0.1:3301'
    }) };
    return { stdout: '' };
  });
  await installService(['kilo']);
  const replacement = join(directory, 'home/Library/LaunchAgents/ai.grunt.service.plist');
  expect(await readFile(replacement, 'utf8')).toContain(join(directory, 'grunt/runtime/daemon.mjs'));
  expect(await readFile(replacement, 'utf8')).toContain('<key>GRUNT_OPENCODE_URL</key><string>http://127.0.0.1:3301</string>');
  expect(fixture.execFile.mock.calls.map(([, args]) => args)).toEqual(expect.arrayContaining([
    ['bootout', `gui/${process.getuid!()}/ai.milo.service`], ['bootstrap', `gui/${process.getuid!()}`, replacement]
  ]));
  expect(JSON.parse(await readFile(join(directory, 'grunt/installed-port.json'), 'utf8'))).toBe(8792);
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preflights Windows through Task Scheduler without npm or tar', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  const run = vi.fn(async () => {});
  await preflight(run);
  expect(run.mock.calls).toEqual([['schtasks.exe', ['/query']]]);
});

it('registers a limited Windows logon task and restarts it with the saved environment on rerun', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  const config = join(directory, 'Grunt & local state');
  vi.stubEnv('GRUNT_CONFIG_DIR', config);
  await mkdir(config, { mode: 0o700 });
  await writeFile(join(config, 'opencode-free.json'), '{}', { mode: 0o600 });
  let definition = '', state = 0;
  fixture.execFile.mockImplementation(async (binary: string, args: string[]) => {
    if (binary === 'whoami.exe') return { stdout: '"LOCAL\\jellybean","S-1-5-21-123-456-789-1000"\r\n' };
    if (binary === 'powershell.exe') {
      return { stdout: state ? JSON.stringify({ state, node: process.execPath, args: `"${join(config, 'runtime/launch.mjs')}"`, limited: true }) : '' };
    }
    expect(binary).toBe('schtasks.exe');
    if (args[0] === '/create') {
      definition = await readFile(args[args.indexOf('/xml') + 1]!, 'utf16le');
      state = 3;
    }
    if (args[0] === '/end') state = 3;
    if (args[0] === '/run') state = 4;
    return { stdout: '' };
  });
  await installService(['kilo']);
  const path = join(config, 'runtime/launch.mjs');
  const launcher = await readFile(path, 'utf8');
  expect(definition).toContain('<LogonTrigger><UserId>S-1-5-21-123-456-789-1000</UserId>');
  expect(definition).toContain('<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>');
  expect(definition).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
  expect(definition).toContain(`<Command>${process.execPath}</Command>`);
  expect(definition).toContain(`<Arguments>&quot;${path.replace('&', '&amp;')}&quot;</Arguments>`);
  expect(launcher).toContain('import("./daemon.mjs")');
  const env = JSON.parse(launcher.split('\n')[0]!.slice('const environment = '.length, -1));
  expect(env).toMatchObject({ GRUNT_DAEMON: '1', GRUNT_SOURCES: 'kilo', GRUNT_PORT: '18792', GRUNT_CONFIG_DIR: config, OPENCODE_CONFIG: join(config, 'opencode-free.json') });
  vi.stubEnv('GRUNT_PORT', '18793');
  await installService(['kilo', 'opencode']);
  expect(await readFile(path, 'utf8')).toBe(launcher);
  const commands = fixture.execFile.mock.calls.filter(([binary]) => binary === 'schtasks.exe').map(([, args]) => args[0]);
  expect(commands).toEqual(['/create', '/run', '/end', '/run']);
  expect(fixture.spawn).not.toHaveBeenCalled();
  await chmod(join(config, 'installed-port.json'), 0o644);
  expect(await installedPort({ GRUNT_CONFIG_DIR: config })).toBe(18792);
  await expect(stat(join(config, 'runtime/package.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
