import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as ChildProcess from 'node:child_process';
import type * as FileSystem from 'node:fs/promises';
import type * as OperatingSystem from 'node:os';

const fixture = vi.hoisted(() => ({
  spawn: vi.fn(), execFile: vi.fn(), copy: vi.fn(async () => {}),
  serviceEnvironment: '',
  holdNpm: false, child: undefined as EventEmitter | undefined,
  abortAt: undefined as string | undefined, controller: undefined as AbortController | undefined
}));
vi.mock('node:child_process', async original => ({ ...await original<typeof ChildProcess>(), spawn: fixture.spawn,
  execFile: Object.assign(fixture.execFile, { [Symbol.for('nodejs.util.promisify.custom')]: fixture.execFile }) }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof FileSystem>(), cp: fixture.copy }));
vi.mock('node:os', async original => {
  const actual = await original<typeof OperatingSystem>();
  return { ...actual, homedir: () => process.env.GRUNT_TEST_INSTALL_HOME || actual.homedir() };
});

import { installService, installBackgroundService } from './wizard.js';
import { automaticPoolSelection } from './automatic-pool.js';

let directory: string;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(async () => {
  vi.clearAllMocks(); fixture.holdNpm = false; fixture.child = undefined; fixture.abortAt = undefined;
  fixture.serviceEnvironment = '';
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
    if (binary === 'npm' && fixture.holdNpm) { fixture.child = child; return child; }
    queueMicrotask(() => {
      if (args.includes(fixture.abortAt ?? 'unmatched')) fixture.controller!.abort(new Error('Setup ownership lost'));
      else child.emit('exit', 0);
    });
    return child;
  });
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it('does not start an already-cancelled runtime installation', async () => {
  fixture.controller!.abort();
  await expect(installService(['kilo'], { signal: fixture.controller!.signal })).rejects.toThrow();
  expect(fixture.copy).not.toHaveBeenCalled(); expect(fixture.spawn).not.toHaveBeenCalled();
  expect(await readFile(join(directory, 'grunt', 'installed-sources.json'), 'utf8')).toBe('["opencode"]');
});

it('cancels a held npm install without later publishing a unit, restarting or replacing saved sources', async () => {
  const unit = join(directory, 'xdg', 'systemd', 'user', 'milo.service');
  await mkdir(join(directory, 'xdg', 'systemd', 'user'), { recursive: true });
  await writeFile(unit, 'previous service', { mode: 0o600 });
  const before = await stat(unit);
  fixture.holdNpm = true;
  const pending = installService(['kilo'], { signal: fixture.controller!.signal });
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(fixture.child).toBeDefined());
  expect(fixture.spawn.mock.calls[0]![2].signal).toBe(fixture.controller!.signal);
  fixture.controller!.abort(new Error('Setup ownership lost'));
  await rejected;
  fixture.child!.emit('exit', 0); // A late completion cannot resume the obsolete owner.
  expect(fixture.spawn.mock.calls.map(([binary]) => binary)).toEqual(['npm']);
  expect(await readFile(unit, 'utf8')).toBe('previous service');
  expect((await stat(unit)).mtimeMs).toBe(before.mtimeMs);
  expect(await readFile(join(directory, 'grunt', 'installed-sources.json'), 'utf8')).toBe('["opencode"]');
  await expect(readFile(join(directory, 'grunt', 'installed-port.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('propagates ownership cancellation to systemd and does not continue with enable/restart/persistence', async () => {
  fixture.abortAt = 'daemon-reload';
  await expect(installService(['kilo'], { signal: fixture.controller!.signal })).rejects.toThrow();
  expect(fixture.spawn.mock.calls.map(([binary, args]) => [binary, args])).toHaveLength(2);
  expect(fixture.spawn.mock.calls[1]![1]).toEqual(['--user', 'daemon-reload']);
  expect(await readFile(join(directory, 'grunt', 'installed-sources.json'), 'utf8')).toBe('["opencode"]');
});

it('does not swallow cancellation of launchctl bootout and bootstrap an obsolete installation', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  fixture.abortAt = 'bootout';
  await expect(installService(['kilo'], { signal: fixture.controller!.signal })).rejects.toThrow();
  expect(fixture.spawn.mock.calls.map(([binary]) => binary)).toEqual(['npm', 'launchctl']);
  expect(fixture.spawn.mock.calls[1]![1][0]).toBe('bootout');
  expect(await readFile(join(directory, 'grunt', 'installed-sources.json'), 'utf8')).toBe('["opencode"]');
});

it('publishes a successful installation with the same owner signal on every child command', async () => {
  await installService(['kilo'], { signal: fixture.controller!.signal });
  expect(fixture.spawn.mock.calls.map(([binary]) => binary)).toEqual(['npm', 'systemctl', 'systemctl', 'systemctl']);
  for (const [, , options] of fixture.spawn.mock.calls) expect(options.signal).toBe(fixture.controller!.signal);
  expect(fixture.spawn.mock.calls.at(-1)![1]).toEqual(['--user', 'restart', 'grunt.service']);
  expect(await readFile(join(directory, 'grunt', 'installed-sources.json'), 'utf8')).toBe('["kilo"]');
  expect(JSON.parse(await readFile(join(directory, 'grunt', 'installed-port.json'), 'utf8'))).toBe(18792);
  expect((await stat(join(directory, 'grunt', 'installed-port.json'))).mode & 0o777).toBe(0o600);
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

it('writes Grunt service identity and primary environment names for a fresh install', async () => {
  vi.stubEnv('GRUNT_FREELLMAPI_URL', 'http://127.0.0.1:3301/v1');
  await installService(['kilo']);
  const unit = await readFile(join(directory, 'xdg/systemd/user/grunt.service'), 'utf8');
  expect(unit).toContain('GRUNT_CONFIG_DIR='); expect(unit).toContain('GRUNT_PORT=18792');
  expect(unit).toContain('GRUNT_SOURCES=kilo'); expect(unit).toContain('GRUNT_FREELLMAPI_URL=http://127.0.0.1:3301/v1');
  expect(unit).not.toContain('MILO_');
  expect(JSON.parse(await readFile(join(directory, 'grunt/runtime/package.json'), 'utf8')).name).toBe('grunt-runtime');
});

it.each(['milo', 'grunt'])('preserves the installed %s unit, custom drop-in and effective port without creating a duplicate', async identity => {
  const units = join(directory, 'xdg/systemd/user'), unit = join(units, `${identity}.service`), dropIn = join(units, `${identity}.service.d/custom.conf`);
  const prefix = identity.toUpperCase();
  const entry = join(directory, 'grunt/runtime/dist/local/main.js');
  const original = `[Service]\nExecStart="${process.execPath}" "${entry}"\nEnvironment="${prefix}_CONFIG_DIR=${join(directory, 'grunt')}"\nEnvironment="${prefix}_PORT=8788"\n`;
  const custom = `[Service]\nEnvironment="${prefix}_PORT=8792"\nEnvironment="${prefix}_FREELLMAPI_URL=http://127.0.0.1:3301/v1"\n`;
  await mkdir(join(units, `${identity}.service.d`), { recursive: true });
  await writeFile(unit, original, { mode: 0o600 }); await writeFile(dropIn, custom, { mode: 0o600 });
  fixture.serviceEnvironment = `${prefix}_CONFIG_DIR=${join(directory, 'grunt')} ${prefix}_PORT=8792 ${prefix}_SOURCES=opencode,kilo ${prefix}_FREELLMAPI_URL=http://127.0.0.1:3301/v1`;
  await installService(['kilo', 'antseed-vikey', 'freellmapi']);
  expect(await readFile(unit, 'utf8')).toBe(original); expect(await readFile(dropIn, 'utf8')).toBe(custom);
  expect(fixture.spawn.mock.calls.map(([binary, args]) => [binary, args])).toEqual([
    ['npm', expect.any(Array)], ['systemctl', ['--user', 'restart', `${identity}.service`]]
  ]);
  expect(JSON.parse(await readFile(join(directory, 'grunt/installed-port.json'), 'utf8'))).toBe(8792);
  // The owned service file can keep its old source environment while setup
  // enrolls newly curated sources through a private, matching selection anchor.
  expect(automaticPoolSelection(join(directory, 'grunt'), ['opencode', 'kilo'], ['opencode', 'kilo', 'reflection-beam'], true).sources).toEqual(['opencode', 'kilo', 'antseed-vikey', 'freellmapi', 'reflection-beam']);
  expect(automaticPoolSelection(join(directory, 'grunt'), ['kilo'], ['opencode', 'kilo', 'reflection-beam'], true).sources).toEqual(['kilo']);
  expect(JSON.parse(await readFile(join(directory, 'grunt/installed-sources.json'), 'utf8'))).toEqual(['kilo', 'antseed-vikey', 'freellmapi']);
  await expect(readFile(join(units, `${identity === 'grunt' ? 'milo' : 'grunt'}.service`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves the legacy native router service identity and saved environment', async () => {
  const unit = join(directory, 'xdg/systemd/user/milo-router.service'), entry = join(directory, 'grunt/runner.mjs');
  const original = `[Service]\nExecStart="${process.execPath}" "${entry}"\nEnvironment="MILO_ROUTER_ENTRY=/saved/router/server.js"\n`;
  await mkdir(join(directory, 'xdg/systemd/user'), { recursive: true }); await writeFile(unit, original, { mode: 0o600 });
  await installBackgroundService('grunt-router', entry, { GRUNT_ROUTER_ENTRY: '/new/router/server.js' });
  expect(await readFile(unit, 'utf8')).toBe(original);
  expect(fixture.spawn.mock.calls.map(([, args]) => args)).toEqual([['--user', 'restart', 'milo-router.service']]);
  await expect(readFile(join(directory, 'xdg/systemd/user/grunt-router.service'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not start either identity when duplicate legacy and Grunt services are installed', async () => {
  const units = join(directory, 'xdg/systemd/user'), entry = join(directory, 'grunt/runner.mjs');
  const original = `[Service]\nExecStart="${process.execPath}" "${entry}"\n`;
  await mkdir(units, { recursive: true });
  for (const name of ['grunt-router', 'milo-router']) await writeFile(join(units, `${name}.service`), original, { mode: 0o600 });
  await expect(installBackgroundService('grunt-router', entry, {})).rejects.toThrow('Multiple Grunt service identities');
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

it('reuses the legacy macOS launch agent and preserves its port and endpoint settings', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  const file = join(directory, 'home/Library/LaunchAgents/ai.milo.service.plist');
  const entry = join(directory, 'grunt/runtime/dist/local/main.js');
  const original = `<plist><array><string>${process.execPath}</string><string>${entry}</string></array><dict><key>MILO_PORT</key><string>8792</string><key>MILO_FREELLMAPI_URL</key><string>http://127.0.0.1:3301/v1</string></dict></plist>`;
  await mkdir(join(directory, 'home/Library/LaunchAgents'), { recursive: true }); await writeFile(file, original, { mode: 0o600 });
  fixture.execFile.mockImplementation(async (_binary: string, args: string[]) => {
    if (args.includes('EnvironmentVariables.MILO_CONFIG_DIR')) return { stdout: join(directory, 'grunt') + '\n' };
    if (args.includes('EnvironmentVariables.MILO_PORT')) return { stdout: '8792\n' };
    throw new Error('Synthetic primary plist variable is absent');
  });
  await installService(['kilo']);
  expect(await readFile(file, 'utf8')).toBe(original);
  expect(fixture.spawn.mock.calls.slice(1).map(([, args]) => args)).toEqual([
    ['bootout', `gui/${process.getuid!()}/ai.milo.service`], ['bootstrap', `gui/${process.getuid!()}`, file]
  ]);
  expect(JSON.parse(await readFile(join(directory, 'grunt/installed-port.json'), 'utf8'))).toBe(8792);
  await expect(readFile(join(directory, 'home/Library/LaunchAgents/ai.grunt.service.plist'))).rejects.toMatchObject({ code: 'ENOENT' });
});
