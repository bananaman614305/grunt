import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as ChildProcess from 'node:child_process';
import type * as FileSystem from 'node:fs/promises';
import type * as OperatingSystem from 'node:os';

const fixture = vi.hoisted(() => ({
  spawn: vi.fn(), copy: vi.fn(async () => {}),
  holdNpm: false, child: undefined as EventEmitter | undefined,
  abortAt: undefined as string | undefined, controller: undefined as AbortController | undefined
}));
vi.mock('node:child_process', async original => ({ ...await original<typeof ChildProcess>(), spawn: fixture.spawn }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof FileSystem>(), cp: fixture.copy }));
vi.mock('node:os', async original => {
  const actual = await original<typeof OperatingSystem>();
  return { ...actual, homedir: () => process.env.GRUNT_TEST_INSTALL_HOME || actual.homedir() };
});

import { installService } from './wizard.js';

let directory: string;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(async () => {
  vi.clearAllMocks(); fixture.holdNpm = false; fixture.child = undefined; fixture.abortAt = undefined;
  fixture.controller = new AbortController();
  directory = await mkdtemp(join(tmpdir(), 'grunt-install-cancel-'));
  vi.stubEnv('MILO_CONFIG_DIR', join(directory, 'milo'));
  vi.stubEnv('XDG_CONFIG_HOME', join(directory, 'xdg'));
  vi.stubEnv('GRUNT_TEST_INSTALL_HOME', join(directory, 'home'));
  vi.stubEnv('MILO_PORT', '18792');
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  await mkdir(join(directory, 'milo'), { mode: 0o700 });
  await writeFile(join(directory, 'milo', 'installed-sources.json'), '["opencode"]', { mode: 0o600 });
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
  expect(await readFile(join(directory, 'milo', 'installed-sources.json'), 'utf8')).toBe('["opencode"]');
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
  expect(await readFile(join(directory, 'milo', 'installed-sources.json'), 'utf8')).toBe('["opencode"]');
});

it('propagates ownership cancellation to systemd and does not continue with enable/restart/persistence', async () => {
  fixture.abortAt = 'daemon-reload';
  await expect(installService(['kilo'], { signal: fixture.controller!.signal })).rejects.toThrow();
  expect(fixture.spawn.mock.calls.map(([binary, args]) => [binary, args])).toHaveLength(2);
  expect(fixture.spawn.mock.calls[1]![1]).toEqual(['--user', 'daemon-reload']);
  expect(await readFile(join(directory, 'milo', 'installed-sources.json'), 'utf8')).toBe('["opencode"]');
});

it('does not swallow cancellation of launchctl bootout and bootstrap an obsolete installation', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  fixture.abortAt = 'bootout';
  await expect(installService(['kilo'], { signal: fixture.controller!.signal })).rejects.toThrow();
  expect(fixture.spawn.mock.calls.map(([binary]) => binary)).toEqual(['npm', 'launchctl']);
  expect(fixture.spawn.mock.calls[1]![1][0]).toBe('bootout');
  expect(await readFile(join(directory, 'milo', 'installed-sources.json'), 'utf8')).toBe('["opencode"]');
});

it('publishes a successful installation with the same owner signal on every child command', async () => {
  await installService(['kilo'], { signal: fixture.controller!.signal });
  expect(fixture.spawn.mock.calls.map(([binary]) => binary)).toEqual(['npm', 'systemctl', 'systemctl', 'systemctl']);
  for (const [, , options] of fixture.spawn.mock.calls) expect(options.signal).toBe(fixture.controller!.signal);
  expect(fixture.spawn.mock.calls.at(-1)![1]).toEqual(['--user', 'restart', 'milo.service']);
  expect(await readFile(join(directory, 'milo', 'installed-sources.json'), 'utf8')).toBe('["kilo"]');
});

it('keeps the no-options installation API compatible', async () => {
  await installService(['kilo']);
  expect(fixture.spawn.mock.calls.at(-1)![1]).toEqual(['--user', 'restart', 'milo.service']);
  for (const [, , options] of fixture.spawn.mock.calls) expect(options.signal).toBeUndefined();
});
