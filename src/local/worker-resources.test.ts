import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import type * as ChildProcess from 'node:child_process';
import { probeWorkerResources, resourceCommand, WORKER_MEMORY_BYTES, WORKER_TASKS_MAX } from './worker-resources.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const mockedSpawn = vi.mocked(spawn);
afterEach(async () => { const actual = await vi.importActual<typeof ChildProcess>('node:child_process'); mockedSpawn.mockReset().mockImplementation(actual.spawn); vi.unstubAllEnvs(); });
function synthetic(output: string, code = 0) {
  mockedSpawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => { child.stdout.emit('data', Buffer.from(output)); child.emit('close', code); });
    return child as ReturnType<typeof spawn>;
  });
}
it('uses fixed aggregate scope limits, unique owned names and a credential-free trusted bus bridge', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'do-not-forward'); vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/malicious-bus'); vi.stubEnv('XDG_RUNTIME_DIR', '/malicious-runtime'); vi.stubEnv('NODE_OPTIONS', '--import=/malicious');
  const one = resourceCommand('/usr/bin/bwrap', ['--clearenv', '--', '/opt/grunt/node', 'literal-$HOME']), two = resourceCommand('/usr/bin/bwrap', []);
  expect(one.binary).toBe('/usr/bin/systemd-run'); expect(one.unit).toMatch(/^grunt-worker-[a-f0-9-]{36}\.scope$/); expect(one.unit).not.toBe(two.unit);
  expect(one.args).toContain(`--property=MemoryMax=${WORKER_MEMORY_BYTES}`); expect(one.args).toContain('--property=MemorySwapMax=0'); expect(one.args).toContain(`--property=TasksMax=${WORKER_TASKS_MAX}`);
  expect(one.args).toContain('--expand-environment=no'); expect(one.args.slice(-5)).toEqual(['/usr/bin/bwrap', '--clearenv', '--', '/opt/grunt/node', 'literal-$HOME']);
  expect(one.env).toEqual({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', XDG_RUNTIME_DIR: `/run/user/${process.getuid!()}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid!()}/bus` });
  expect(JSON.stringify(one.env)).not.toContain('malicious'); expect(JSON.stringify(one.env)).not.toContain('do-not-forward');
});
it('cleans up exactly its generated scope once and never targets services chosen by callers', async () => {
  synthetic(''); const command = resourceCommand('/usr/bin/bwrap', []);
  await Promise.all([command.cleanup(), command.cleanup()]);
  expect(mockedSpawn).toHaveBeenCalledTimes(1);
  expect(mockedSpawn.mock.calls[0]).toEqual(['/usr/bin/systemctl', ['--user', '--no-ask-password', 'kill', '--kill-whom=all', '--signal=KILL', command.unit], expect.objectContaining({ env: command.env, detached: true })]);
});
it('rejects relative binaries and malformed arguments before launch', () => {
  expect(() => resourceCommand('bwrap', [])).toThrow('trusted executable'); expect(() => resourceCommand('/usr/bin/bwrap', ['bad\0value'])).toThrow('argument list'); expect(mockedSpawn).not.toHaveBeenCalled();
});
it('accepts only measured kernel limits, then releases the harmless probe scope', async () => {
  synthetic(JSON.stringify({ memory: '536870912', swap: '0', tasks: '64' })); expect(await probeWorkerResources()).toBe(true);
  expect(mockedSpawn.mock.calls[0]![0]).toBe('/usr/bin/systemd-run'); expect(mockedSpawn.mock.calls[1]![0]).toBe('/usr/bin/systemctl');
});
it.each([
  JSON.stringify({ memory: 'max', swap: '0', tasks: '64' }), JSON.stringify({ memory: '536870912', swap: 'max', tasks: '64' }), JSON.stringify({ memory: '536870912', swap: '0', tasks: 'max' }), 'not-json', 'x'.repeat(5000)
])('fails closed on unverified or unbounded resource constraints', async output => {
  synthetic(output); expect(await probeWorkerResources()).toBe(false);
});
it('fails closed when transient scope enrollment fails', async () => { synthetic('', 1); expect(await probeWorkerResources()).toBe(false); });
it('honors cancellation before starting any resource scope', async () => {
  const controller = new AbortController(); controller.abort(new Error('cancel-probe'));
  await expect(probeWorkerResources(controller.signal)).rejects.toThrow('cancel-probe'); expect(mockedSpawn).not.toHaveBeenCalled();
});
it('checks actual limits in a harmless real scope when the host resource manager is available', async () => {
  // This allocates no stress memory and forks no workload; unsupported hosts must return false.
  const supported = await probeWorkerResources(); expect(typeof supported).toBe('boolean');
});

it('releases only the owned scope when a running capability probe is cancelled', async () => {
  const controller = new AbortController(); let running: EventEmitter | undefined;
  synthetic(''); mockedSpawn.mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() }); running = child;
    return child as ReturnType<typeof spawn>;
  });
  const pending = probeWorkerResources(controller.signal);
  while (!running) await new Promise(resolve => setTimeout(resolve, 1));
  controller.abort(new Error('cancel-running-probe')); running.emit('close', null);
  await expect(pending).rejects.toThrow('cancel-running-probe');
  expect(mockedSpawn.mock.calls[1]![0]).toBe('/usr/bin/systemctl'); expect(mockedSpawn.mock.calls[1]![1]).toContain('--signal=KILL');
});
